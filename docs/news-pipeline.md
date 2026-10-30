# The news pipeline

How a few hundred headlines a day become one reader's twenty — and the cost model that makes it work for more than one user.

The rule everything here serves: **never run the full Gemini pipeline per user.**

### Cost-aware news design (multi-user)

Never run the full Gemini pipeline per user. Built in Phase 3 and live:

1. `ingest-news` (cron, once daily ~06:30 IST / 01:00 UTC): for every category any enabled user
   follows, fetch that category's feeds, run the item pipeline below, then summarize + embed
   **once** into the shared `articles` pool.
2. `build-digests` (cron, right after): per user, a single Gemini call ranks that day's pooled
   articles for the user's categories against `profiles.news_profile`, picks top N, writes
   `why_it_matters`, and inserts `digests` + `news_items` (copying fields + embedding).
   Still to do (Phase 6) — follow-up linking: nearest neighbour among that user's `news_items`
   from the last 14 days (cosine similarity threshold ~0.85, tune it) → `related_item_id`.

#### Item pipeline (helpers all live in `_shared/feeds.ts`)

1. **Parse + normalize** (`fetchFeed`/`parseFeed`) — strip tracking params, repair the SEBI quirks,
   resolve the publisher domain (for aggregator items from `<source url>`, not the feed name).
2. **Resolve redirect links** (`resolveItemUrl`) — unwrap the legacy `?url=` form and follow
   redirects. **Known limitation:** current Google News `/rss/articles/CBMi…` links cannot be
   resolved server-side at all — the id is opaque, the article page does the hop in client-side JS,
   and the `DotsSplashUi`/`Fbv4je` RPC that every library used now returns an empty result even
   with the page's own signature and timestamp (all three verified against live links 2026-10-12).
   Those items keep the Google link with `resolved: false`; the link still works in a browser, and
   step 4 prefers a direct feed's URL for the same story whenever one exists. Re-test occasionally.
3. **Enrich thin excerpts** (`fetchExcerpt`) — several feeds ship a headline and nothing else
   (Hugging Face, the GitHub release feeds, RBI). Below `THIN_EXCERPT_CHARS` the article page is
   fetched and its `og:description` / meta description used instead. Guards that matter: skip
   unresolved Google News links (their page describes Google News), skip non-`text/html` (SEBI
   links straight to PDFs), and require 60+ characters because Hugging Face serves "A Blog post
   by Ai2 on Hugging Face" and RBI "Press Releases - Reserve Bank of India" for every article.
   The floor has a real cost: some pages have nothing usable at all, and those keep a
   title-only summary. Measured on a repair run over 8 such articles, 5 were fixed and 3 were
   not — Hugging Face (boilerplate on every post), a Substack whose description names its
   audience rather than its content, and a page with no description tag. Reading the page body
   instead would need real content extraction: the first `<p>` on a Hugging Face blog post is
   the site navigation, so a naive body fallback would summarize a menu.
4. **Filter junk** (`isJunk`) — sponsored/brand-post/advertorial, plus the stock-tip genre that
   floods the Indian market feeds (multibagger, "top 5 stocks to buy", "trade setup", target
   prices) and recurring filler. Tip patterns match on the **title only**: a real story may quote
   an analyst's target price in its body. Typically drops ~17 of 600 items.
5. **Merge duplicates** (`mergeStories`) — exact URL first, then headline similarity
   (`DUPLICATE_THRESHOLD = 0.45` Jaccard over stopword-filtered title tokens, within one category).
   Produces `source_count` = distinct newsrooms carrying the story (`publisherKey` folds `m.`/`amp.`
   hosts and split domains like ET's, so one newsroom never counts twice). The canonical item is
   picked as resolved-URL > higher tier > longer headline — so an aggregator can tell us a story is
   big while a primary source supplies the link.
6. **Categorize from content** — the summarize call also returns the `category`, constrained to
   the enum in `NEWS_CATEGORIES`. The feed's category is passed only as a hint and is often
   wrong: a Reuters _tech_ query carries rupee/RBI stories, an Indian startup query carries
   DeepSeek funding. Anything outside the enum keeps the feed's category. ~20% of items get
   re-filed. Note this means a category's pool can contain articles that arrived via another
   category's feeds.
7. **Rank** — `describeForRanking` renders one line per story carrying `tier` and `source_count`,
   the two signals the model cannot infer from a headline. Instruct it to treat `primary` as
   authoritative, and a high `source_count` as corroboration/importance rather than as quality.

- **URLs must come only from fetched feed items.** `build-digests` has the model return indices
  into the candidate list instead of URLs, so there is nothing to validate after the fact.

#### Measured in production (2026-10-12, 5 followed categories, 43 feeds)

Fan-out run, one invocation per category:

| category               | runtime | parsed | in window | stories | shortlist | new | inserted |
| ---------------------- | ------- | ------ | --------- | ------- | --------- | --- | -------- |
| AI                     | 39.0s   | 600    | 119       | 112     | 40        | 31  | 31       |
| Indian Stock Market    | 30.9s   | 270    | 219       | 176     | 40        | 20  | 20       |
| Global Tech            | 22.7s   | 149    | 121       | 118     | 40        | 18  | 18       |
| Indian Startups & Tech | 14.7s   | 204    | 78        | 69      | 40        | 10  | 10       |
| Software Development   | 13.8s   | 117    | 15        | 15      | 15        | 2   | 2        |

- **14 Gemini calls**, 10.0k input / 4.4k output tokens across the five invocations.
  Longest single invocation **39s** against the 150s wall clock (the old single-invocation
  run was 71s and growing with every feed added).
- `build-digests`: 14s, **1 Gemini call**, 16.6k input / 1.3k output, 171 candidates → 20 items.
  The marginal cost of each extra user is still one flash call over the same pool.
- Pool that day: 198 articles, 59 publishers, 68 aggregator-tier, 54 unresolved URLs,
  11 stories corroborated by more than one newsroom.

#### Google News is blocked from the Edge runtime — fetched from Postgres instead

All Google News feeds answer **HTTP 503** inside an Edge Function while the identical URL
returns 200 from Postgres egress (`net.http_get`) and from a laptop: Google blocks the
functions network's IP range. Retries cannot fix a block, so the aggregator tier is fetched
by the database instead:

1. `prefetch_feeds` holds the aggregator URLs. **ingest-news writes this table on every
   run** from `FEEDS`, so `_shared/feeds.ts` stays the single source of truth and adding a
   feed needs no SQL change.
2. `prefetch_aggregator_feeds()` (cron 00:50 UTC, 10 min ahead of ingest) fires one
   `net.http_get` per URL and records the request id → URL mapping in `prefetch_requests`,
   because `net._http_response` does not store the URL.
3. `get_prefetched_feeds(interval)` — service-role-only RPC — returns `(url, status_code,
content)` for requests newer than the interval. `ingest-news` prefers a prefetched body
   and falls back to a direct fetch on a miss, so a failed prefetch degrades rather than breaks.

Verified: all 9 aggregator feeds prefetch at HTTP 200 (153KB for the AI query), and a run
pooled 68 aggregator-tier articles of which 54 carry `url_resolved = false`.

### Source map (`_shared/feeds.ts`) — all URLs verified 2026-10-12

Every feed is `{ url, name, category, tier }`. **Tier is the trust signal** and is passed to the
ranking prompt:

- `primary` — the actor speaking for itself (regulator, lab, release feed). First-hand facts.
- `trusted` — a newsroom with an editor, reporting on someone else.
- `aggregator` — Google News / Hacker News. Best recall and the signal of what is breaking, but
  no editorial control and the links need cleaning.

43 feeds: 15 primary, 19 trusted, 9 aggregator.

- **AI**: OpenAI, Google DeepMind, Hugging Face blogs (primary) · MIT Technology Review,
  Simon Willison, The Verge AI, **TechCrunch AI**, **The Decoder** (trusted) · Google News
  `"artificial intelligence"`, **`hnrss.org/newest?q=AI+OR+LLM&points=50`** (aggregator).
  The two newsrooms and the hnrss query were added because the lab blogs post every few
  days: one run found only 5 AI candidates all day. Now ~40.
- **Software Development**: GitHub Blog + `releases.atom` for node, TypeScript, Deno, React, Vite,
  Tailwind, Supabase, Postgres (primary) · InfoQ (trusted) · `hnrss.org/frontpage?points=100`
  (aggregator — the points threshold is why we use hnrss over the official HN feed)
- **Indian Stock Market**: RBI press releases + RBI notifications + SEBI (primary) · ET Markets,
  Livemint Markets, Business Standard Markets (trusted) · Google News IN `Sensex OR Nifty`
- **Indian Startups & Tech**: Inc42, Entrackr, YourStory, Livemint Companies, Business Standard
  Companies (trusted) · Google News IN `India startup funding`
- **Global Tech**: The Verge, TechCrunch, Ars Technica (trusted) · Google News
  `technology site:reuters.com` (aggregator — Reuters killed its public RSS, a site: query is the
  only way in)
- **Policy & Regulation**: MediaNama, Business Standard Economy & Policy (trusted) · Google News
  `site:pib.gov.in`, `(DPDP OR "data protection" OR TRAI OR MeitY) India`, `"AI regulation"`
- X/Twitter highlights: later phase (X API is paid). Option: Gemini with Google Search grounding,
  using only URLs from grounding metadata.

#### Feed gotchas (all of these cost an hour to find; don't rediscover them)

- **Send a browser User-Agent.** Business Standard answers 403 to anything bot-shaped. `feeds.ts`
  sets this for every fetch.
- **Dead, in `DROPPED` with reasons — do not re-add**: **VentureBeat** (HTTP 429 on every path,
  spaced out — a block, not rate limiting to wait out); no Ars Technica AI feed exists;
  PIB's `RssMain.aspx` (serves an `<rss>` with
  an empty `<channel>` for every ModId/Regid combination, so PIB is reached via a `site:` query
  instead); **Moneycontrol** (feed abandoned, newest item 23 Apr 2024 — it was in the old plan);
  Anthropic (no public RSS); the old `deepmind.google/discover/blog` path.
- Entrackr is `/rss`; `/feed` 404s.
- SEBI emits `"09 Oct, 2026 +0530"`, which `Date.parse` rejects → `parseFeedDate` has a fallback.
  SEBI also prefixes its own origin onto already-absolute links → `normalizeUrl` unwraps that.
- OpenAI and Hugging Face serve their whole archive in one feed (1287 and 876 items), so
  `parseFeed` caps at the 150 newest per feed.
- GitHub release feeds and the lab blogs often have nothing in a 24h window. That is normal, not
  broken — don't drop them for a quiet day.
- A live 24h pull yields roughly **600 items → ~520 stories after junk filtering and merging**.
