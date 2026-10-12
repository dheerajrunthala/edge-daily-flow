# Daily Edge — AI-powered personal productivity + news brief

Multi-user web app (open signups). Built by an Indian software engineer as a showcase of practical
AI use for efficiency: task management with natural-language input, and a daily AI-curated news
digest delivered by email. Used via the published Lovable URL; mobile app may come later on the
same Supabase backend.

## Ownership split (important)

- **Schema** baseline was created by hand from `supabase/migrations/20261012000000_init_schema.sql`
  and `20261012000100_onboarding.sql` (run in the SQL editor). All further changes are new
  migration files in `supabase/migrations/`, applied via the Supabase MCP and committed.
- **Lovable** built the initial UI and wired it to the existing tables (no schema, no functions).
  It syncs two-way with this repo's default branch.
- **Claude Code owns everything from now on**: frontend changes, schema, Edge Functions, cron.
- Always `git pull` before starting work; push small, focused commits; never leave the tree dirty
  (Lovable may push to the same branch).
- Keep Lovable's layout: Vite + React + TS + Tailwind + shadcn/ui, Supabase client in
  `src/integrations/supabase/`. Regenerate types after schema changes.

## Stack

- Frontend: React + Vite + TypeScript + Tailwind + shadcn/ui, React Query, recharts.
- Backend: Supabase (Postgres, Auth, Edge Functions in Deno, pg_cron, pg_net, pgvector, Vault).
- AI: Gemini API — a current Flash model for parsing/summaries; a Gemini embedding model (768-dim
  output) for news similarity. Model names live in `_shared/gemini.ts` constants.
- Email: Gmail SMTP + App Password from Edge Functions (see limits below).

## Supabase access & safety

- Use the Supabase MCP server (scoped to this project) to inspect schema/data, apply migrations,
  deploy functions, and read logs.
- This is production with real users' data. Before destructive SQL (DROP, DELETE without WHERE,
  type changes, disabling RLS) — stop and ask.
- RLS is on for every table (`user_id = auth.uid()`). New tables must enable RLS with policies.
  Edge Functions use the service role only server-side.

## Secrets — never in code, commits, or this file

Edge Function secrets (set by the owner with `supabase secrets set`):
`GEMINI_API_KEY`, `GMAIL_USER`, `GMAIL_APP_PASSWORD`, `CRON_SECRET`, `APP_URL` (published Lovable URL).
Vault (for pg_cron → functions): `project_url`, `cron_secret`.
Cron-invoked functions require header `x-cron-secret` = `CRON_SECRET`. User-invoked functions
require a valid user JWT. The browser never calls Gemini.

## Email

- Supabase Edge Functions block outbound ports 25 and 587 → use **smtp.gmail.com:465** (implicit TLS),
  e.g. `npm:nodemailer`.
- Gmail caps sending at roughly 500 recipients/day. Fine for now; keep sending behind
  `_shared/email.ts` so swapping to Resend later is one file.
- Recipient = the user's auth email (look up via service role), never GMAIL_USER.
- Every email has a footer link to `${APP_URL}/settings` to change times or turn off the digest.
- Inline-styled, simple HTML (Gmail strips <style>). Include a plain-text part.

## Data model (source of truth = migration files)

- `profiles` (id, full_name, timezone default 'Asia/Kolkata', news_profile, onboarded_at)
- `tags` (user_id, name, color token; 6 defaults seeded on signup by `handle_new_user`)
- `tasks` (title, notes, due_at null = someday, all_day, recurrence none|daily|weekly|monthly|yearly,
  priority, status todo|done, tags text[] of tag names, remind_before interval, last_reminded_at,
  completed_at, source manual|ai)
  - Completing a recurring task inserts `task_completions` and moves `due_at` to the next occurrence.
  - Birthdays = yearly tasks tagged "Birthday".
- `task_completions` (task_id, due_at of the occurrence, completed_at)
- `news_prefs` (categories text[], headline_count 10|20|30, email_times text[] 'HH:MM' in the user's
  profile timezone, enabled)
- `digests` (user_id, digest_date, status pending|ready|failed, summary, items_count,
  sources_scanned, emailed_at) unique per user per day
- `news_items` (per-user digest entries: category, headline, summary, why_it_matters, url, source,
  importance, rank, embedding, related_item_id, is_saved — users may only update is_saved)
- `ai_events` (user_id, kind, items_processed, tokens) → Insights page + rate limiting

## Cost-aware news design (multi-user)

Don't run the full Gemini pipeline per user. Phase 3 should add (via migration) a **shared daily
article pool**, e.g. `articles` (category, url unique, title, source, published_at, summary,
embedding, fetched_on) with RLS allowing authenticated read. Add `tier` and `source_count` columns
so the ranking signals survive into the pool:

1. `ingest-news` (cron, once daily ~06:30 IST / 01:00 UTC): for every category any enabled user
   follows, fetch the feeds for that category, then run the item pipeline below, then summarize +
   embed **once** into `articles`.
2. `build-digests` (cron, right after): per user, a single cheap Gemini call ranks that day's
   pooled articles for the user's categories against `profiles.news_profile`, picks top N, writes
   `why_it_matters`, and inserts `digests` + `news_items` (copying fields + embedding).
   Follow-up linking: nearest neighbour among that user's `news_items` from the last 14 days
   (cosine similarity threshold ~0.85, tune it) → `related_item_id`.

### Item pipeline (helpers all live in `_shared/feeds.ts`)

1. **Parse + normalize** (`fetchFeed`/`parseFeed`) — strip tracking params, repair the SEBI quirks,
   resolve the publisher domain (for aggregator items from `<source url>`, not the feed name).
2. **Resolve redirect links** (`resolveItemUrl`) — unwrap the legacy `?url=` form and follow
   redirects. **Known limitation:** current Google News `/rss/articles/CBMi…` links cannot be
   resolved server-side at all — the id is opaque, the article page does the hop in client-side JS,
   and the `DotsSplashUi`/`Fbv4je` RPC that every library used now returns an empty result even
   with the page's own signature and timestamp (all three verified against live links 2026-10-12).
   Those items keep the Google link with `resolved: false`; the link still works in a browser, and
   step 4 prefers a direct feed's URL for the same story whenever one exists. Re-test occasionally.
3. **Filter junk** (`isJunk`) — sponsored/brand-post/advertorial, plus the stock-tip genre that
   floods the Indian market feeds (multibagger, "top 5 stocks to buy", "trade setup", target
   prices) and recurring filler. Tip patterns match on the **title only**: a real story may quote
   an analyst's target price in its body. Typically drops ~17 of 600 items.
4. **Merge duplicates** (`mergeStories`) — exact URL first, then headline similarity
   (`DUPLICATE_THRESHOLD = 0.45` Jaccard over stopword-filtered title tokens, within one category).
   Produces `source_count` = distinct newsrooms carrying the story (`publisherKey` folds `m.`/`amp.`
   hosts and split domains like ET's, so one newsroom never counts twice). The canonical item is
   picked as resolved-URL > higher tier > longer headline — so an aggregator can tell us a story is
   big while a primary source supplies the link.
5. **Rank** — `describeForRanking` renders one line per story carrying `tier` and `source_count`,
   the two signals the model cannot infer from a headline. Instruct it to treat `primary` as
   authoritative, and a high `source_count` as corroboration/importance rather than as quality.

- **URLs must come only from fetched feed items.** Validate every URL the model returns against
  the input set; drop anything else.

## Edge Functions

1. `parse-task` (user JWT) — free text → Gemini with JSON response schema → array of tasks
   (title, notes, due_at ISO with the user's UTC offset, all_day, recurrence, priority, tags,
   remind_before). Pass today's date, weekday and the user's timezone + existing tag names in the
   prompt. Returns a preview only; the UI saves. Rate limit: 50 calls/user/day (count `ai_events`).
2. `ingest-news` + `build-digests` — see above.
3. `send-briefs` (cron every 15 min) — for each user with `enabled`, check whether one of their
   `email_times` falls in the current 15-min window in their timezone and hasn't been sent today;
   build the email: AI "at a glance", today's tasks, overdue, birthdays in next 7 days, digest by
   category with links and "Follow-up to: <earlier headline> (date)" lines. Track sends
   (add a `brief_sends` table: user_id, sent_for date, slot 'HH:MM', unique).
4. `check-reminders` (cron every 15 min) — tasks where `due_at - remind_before <= now()` and not
   reminded for this occurrence → short email, set `last_reminded_at`.

## Cron (UTC)

- ingest-news: `0 1 * * *`
- build-digests: `30 1 * * *`
- send-briefs: `*/15 * * * *`
- check-reminders: `*/15 * * * *`
  Defined in a migration with `cron.schedule` + `net.http_post`, URL and secret read from Vault.

## Source map (`_shared/feeds.ts`) — all URLs verified 2026-10-12

Every feed is `{ url, name, category, tier }`. **Tier is the trust signal** and is passed to the
ranking prompt:

- `primary` — the actor speaking for itself (regulator, lab, release feed). First-hand facts.
- `trusted` — a newsroom with an editor, reporting on someone else.
- `aggregator` — Google News / Hacker News. Best recall and the signal of what is breaking, but
  no editorial control and the links need cleaning.

40 feeds: 15 primary, 17 trusted, 8 aggregator.

- **AI**: OpenAI, Google DeepMind, Hugging Face blogs (primary) · MIT Technology Review,
  Simon Willison, The Verge AI (trusted) · Google News `"artificial intelligence"` (aggregator)
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

### Feed gotchas (all of these cost an hour to find; don't rediscover them)

- **Send a browser User-Agent.** Business Standard answers 403 to anything bot-shaped. `feeds.ts`
  sets this for every fetch.
- **Dead, in `DROPPED` with reasons — do not re-add**: PIB's `RssMain.aspx` (serves an `<rss>` with
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

## Frontend routes

`/` landing (logged out) · `/login` · `/onboarding` · `/brief` · `/tasks` · `/news` · `/insights` · `/settings`

## Roadmap

- [ ] Phase 1: review Lovable draft against schema; fix data wiring, recurrence roll-forward, types
- [ ] Phase 2: `parse-task` + quick-add preview, rate limiting
- [ ] Phase 3: shared article pool migration, `ingest-news`, `build-digests`, news page polish
- [ ] Phase 4: `send-briefs` + `check-reminders` + cron migration
- [ ] Phase 5: follow-up linking, Insights page with real data, PWA polish
- [ ] Phase 6 (optional): Telegram bot, weekly review email, "ask my news" chat, X highlights

## Working conventions

- Test each Edge Function by invoking it and reading logs via MCP before wiring cron.
- `npm run build` and `npm run lint` must pass before committing frontend changes.
- Shared helpers in `supabase/functions/_shared/` (gemini.ts, email.ts, supabase.ts, feeds.ts, time.ts).
- Log every Gemini call to `ai_events`.
