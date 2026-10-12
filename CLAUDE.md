# Daily Edge — AI-powered personal productivity + news brief

Multi-user web app (open signups). Built by an Indian software engineer as a showcase of practical
AI use for efficiency: task management with natural-language input, and a daily AI-curated news
digest delivered by email. Used via the published app at **https://dailyedgeapp.lovable.app**;
mobile app may come later on the same Supabase backend.

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
`GEMINI_API_KEY`, `GMAIL_USER`, `GMAIL_APP_PASSWORD`, `CRON_SECRET`,
`APP_URL` (`https://dailyedgeapp.lovable.app`),
`TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `TELEGRAM_BOT_USERNAME`,
`VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`.
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

## Notifications (Phase 5)

Every notification in the project goes out through `_shared/notify.ts`, the way every email
goes out through `_shared/email.ts`. `notify(recipient, payload, channels)` fans one payload
across the recipient's enabled channels and reports each independently, so one channel
failing never silences another.

- **Channels** live in `notification_prefs.channels` (`notification_channel` enum).
  All three deliver: `email`, `telegram` and `push` (web push — see below).
  `activeChannels()` is exported separately from `notify()` so a caller can claim its
  idempotency rows per channel before sending.
- `notify()` takes the service-role client as its first argument, because the push sender
  reads the recipient's subscriptions and prunes the dead ones.
- **Quiet hours** are enforced inside notify.ts, never by callers: it is a property of the
  user, and forgetting it at one call site is the bug that wakes someone at 3am. Wall clock
  in the user's timezone, normally wrapping midnight (22:00 → 07:00); `start = end` means
  off. Nothing is claimed or sent during the window, so the ladder simply resumes after it.

### The escalation ladder

A task that opted into reminders (`remind_before` is set) walks these stages:

| stage   | fires                                         | channels        |
| ------- | --------------------------------------------- | --------------- |
| `lead`  | the user's `remind_before`                    | all enabled     |
| `1h`    | one hour before due                           | telegram / push |
| `15m`   | fifteen minutes before due                    | telegram / push |
| `due`   | at `due_at`                                   | all enabled     |
| `nag:k` | `due_at + k × nag_interval`, while still open | telegram / push |

**Email carries `lead` and `due` only** (`EMAIL_STAGES` / `routeStage()` in check-reminders).
Email is the channel you read later, so it gets the two rungs that are still news on a
delay; the in-between rungs and every nag are push-shaped — only useful now, and an inbox
full of "still open" is how a reminder app gets muted. The filter runs **before** the
ledger is claimed, not after: a stage email never carries leaves no email row behind, and a
user whose only channel is email simply has a shorter ladder (`lead` → `due`) rather than
stages that silently go nowhere.

- **`task_notifications` is the ledger, not the timer.** One row per
  (task, occurrence, stage, channel), claimed _before_ the send and deleted again if the
  send fails — the same pattern as `brief_sends`. That is what makes a per-minute cron safe
  to run 1440 times a day, and what makes two overlapping ticks unable to double-send.
- A recurring task rolling `due_at` forward starts a **fresh ladder for free**, because the
  ledger is keyed on `due_at`.
- **Stages that coincide collapse.** With `remind_before` = 1 hour, `lead` and `1h` are the
  same instant; `plan()` keys stages by fire time so the user gets one notification.
- **A stage earlier than `tasks.created_at` never fires.** Creating a task due in five
  minutes must not immediately ping "due in 1 hour". This is also why a 5-minute test task
  only shows `lead` (if `remind_before` ≤ 5 min), `due` and the nags.
- **Several stages pending at once** (the function was down) sends only the latest; the
  older ones are written with `delivered = false` — accounted for, never fired late, and
  not pretending an email went out.
- **`snoozed_until`** retires every stage before it, permanently. The ladder resumes at the
  current nag instead of replaying what it slept through.
- **All-day tasks get only `lead`.** Their `due_at` is local midnight, so escalating through
  "due now" and nagging would mean a birthday pinging you from 00:00.
- Safety rails, deliberately opinionated: stop nagging after `NAG_WINDOW_HOURS = 48` or
  `MAX_NAGS = 24`, whichever comes first, cap `MAX_PER_USER = 5` notifications per tick, and
  drop fixed stages more than `MAX_LATENESS_HOURS = 6` late. Nags are exempt from the
  lateness horizon because `plan()` only ever emits the current one.

### Browser notifications (Phase 6)

Two independent mechanisms, and keeping them separate is the point:

- **In-app (tab open)** — `NotificationCenter`, mounted inside `AppShell`, subscribes over
  Supabase Realtime to the user's own `task_notifications` inserts and renders a toast +
  chime + tab badge. It is a **view of the ledger, not a fourth channel**: the row is
  written by check-reminders _before_ it sends, so an in-app toast cannot disagree with
  what actually went out, nothing is scheduled in the browser, and a laptop waking from
  sleep shows nothing stale because it simply never receives the rows it missed.
  `task_notifications` is in the `supabase_realtime` publication; realtime applies the
  table's own RLS (`user_id = auth.uid()`) to the socket's JWT.
  - One notification writes one row **per channel**, which arrive as separate events, so
    the component collapses on `task_id|due_at|stage` or the user gets three toasts.
  - Rows with `delivered = false` are bookkeeping for a superseded stage and are skipped.
  - The chime is synthesized in WebAudio (no asset) and must be **unlocked on the first
    user gesture** — a context created before any interaction starts suspended and cannot
    be resumed later. A reminder arriving before the first click is therefore silent.
  - Title flash and favicon badge (`src/lib/tab-alert.ts`) only run while the tab is
    hidden, and clear on focus. The title interval re-reads `document.title` whenever it
    is neither of its own two strings, so navigating mid-alert doesn't get overwritten.
- **Web push (tab closed)** — `push_subscriptions` + `public/sw.js` + the `push` channel.
  - **The VAPID public key is served by `push-subscribe`, not bundled.** The keys live
    only in the platform's secret store and rotating them needs no frontend rebuild.
    Secrets: `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` (raw base64url, exactly as
    `npx web-push generate-vapid-keys` prints them), `VAPID_SUBJECT`. `_shared/push.ts`
    splits the 65-byte public point into JWK `x`/`y` because Web Crypto won't import the
    raw form.
  - Sender is `jsr:@negrel/webpush` — Deno-native and Web Crypto only; verified to
    resolve in the Edge runtime. A fresh `ApplicationServer` per send batch, because its
    ECDH key is meant to be ephemeral (RFC 8291 §2).
  - **404/410 means the subscription is gone**, so the row is deleted. That is the whole
    of expiry handling, and why `sendPush` reports `removed` separately from `failed`.
    Every endpoint failing for any _other_ reason throws, so the ledger claim is released
    and the next tick retries.
  - **Done / Snooze 10m are handled in the service worker, which has no Supabase
    session** — it lives in the page's localStorage, which a worker cannot read, and the
    worker often runs with no page open. So each notification carries an HMAC **action
    token** naming one user and one task, expiring in 24h, and `push-action` trusts the
    signature instead of a bearer token. The signing key is HKDF-derived from
    `SUPABASE_SERVICE_ROLE_KEY` (salt `daily-edge/push-action`, info `v1`), so there is no
    extra secret and the derived key cannot be used as the service role. The task is
    re-read scoped to the user id _inside_ the token, exactly as the Telegram webhook
    scopes a press to the chat's user.
  - **Two buttons, not three.** Chrome renders at most two notification actions and
    silently drops the rest; "Tomorrow" stays a Telegram/app affordance.
  - `requireInteraction: true` is honoured on macOS **only** if Chrome's notification
    style is "Alerts", not "Banners" — the Settings card says so, because under Banners
    the card vanishes in seconds and takes the buttons with it.
  - `tag` is `task:<id>` + `renotify`, so a later rung replaces the earlier card in place
    and still alerts rather than stacking three "still open" notifications.
  - **The service worker is a plain `public/sw.js`, deliberately not generated.**
    `vite-plugin-pwa` (`injectManifest`) was tried and emits to `dist/service-worker.js`,
    which the nitro build never copies into `.output/public/` — it would 404 in
    production. There is also nothing to precache (the app is SSR) and nothing to inject:
    every payload carries both the URL to open and the URL to post a button press to, so
    the worker needs no build-time configuration at all.
  - **`pushsubscriptionchange` cannot tell the server** (no session in the worker), so the
    worker only re-subscribes locally and `syncSubscription()` re-upserts whatever the
    browser holds on **every app load**. That plus 404/410 pruning is how a rotated
    endpoint repairs itself.
  - Service workers need a real secure origin: **test on https://dailyedgeapp.lovable.app**,
    never the Lovable preview iframe.

### Telegram (@DailyEdgeAppBot)

- **Linking** is a one-time code: the browser calls `request_telegram_link()` (SECURITY
  DEFINER, authenticated) which mints the code in the database — the browser never invents
  it — and opens `t.me/<bot>?start=<code>`. The webhook consumes the code, binds `chat_id`,
  nulls the code, and switches the `telegram` channel on. Codes are single-use and expire in
  15 minutes. `unlink_telegram()` undoes both halves.
- **Auth** is the `x-telegram-bot-api-secret-token` header against `TELEGRAM_WEBHOOK_SECRET`
  (set via `setWebhook`'s `secret_token`), then `chat_id` → `telegram_links` for identity.
  An unlinked chat can do nothing but `/start`.
- **Registration needs no local secrets**: `POST {"register": true}` with a valid
  `x-cron-secret` makes the function call `setWebhook` on itself, so it can be driven from
  `select public.invoke_edge_function('telegram-webhook', '{"register": true}')` and the bot
  token never leaves the platform's secret store. `{"info": true}` returns `getWebhookInfo`.
- Reminder cards carry inline **Done / Snooze 1h / Tomorrow** buttons; `callback_data` is
  `<action>:<task_id>` and the task is re-read scoped to the chat's user, so a guessed id
  from another account is not actionable. The card is rewritten after the press so spent
  buttons disappear.
- Task mutations the bot performs live in `_shared/tasks.ts`, which mirrors
  `src/lib/task-logic.ts` (recurrence roll-forward, "tomorrow" meaning tomorrow's date
  rather than `due_at + 1 day`) — the bot has no browser to borrow that logic from.

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
  importance, rank, embedding, related_item_id, is_saved, url_resolved — users may only update
  is_saved)
- `articles` — the shared daily pool (category, url unique, title, source, feed_name, tier,
  source_count, published_at, summary, embedding vector(768), url_resolved, fetched_on).
  RLS: authenticated read only; the service role writes. `url` is unique across all time, so an
  article is summarized and embedded exactly once, ever.
- `brief_sends` (user_id, sent_for date, slot 'HH:MM', digest_id, unique on the first three)
  — the idempotency record for send-briefs. Owner-readable.
- `notification_prefs` (user_id, channels `notification_channel[]` default `{email}`,
  quiet_start/quiet_end `time` default 22:00–07:00, nag_interval interval default 15 min)
  — owner-managed, seeded by `handle_new_user`.
- `task_notifications` (user_id, task_id, due_at of the occurrence, stage, channel,
  delivered, sent_at, unique on (task_id, due_at, stage, channel)) — the escalation ledger.
  Owner-readable; the service role writes.
- `tasks.snoozed_until` — "not now"; suppresses every stage before that instant.
- `telegram_links` (user_id, chat_id unique, one-time code + expiry, linked_at)
  — owner-readable only; written by `request_telegram_link()` and the webhook.
- `push_subscriptions` (user_id, endpoint **unique**, p256dh, auth, user_agent,
  last_used_at) — one row per browser that granted permission. The endpoint is the natural
  key, so re-subscribing updates rather than duplicates. Owner may select and delete (the
  Settings list and "turn off"); only `push-subscribe` writes, via the service role.
- `prefetch_feeds` / `prefetch_requests` — plumbing for the Google News workaround below.
  RLS on with **no policies**: service role and SECURITY DEFINER functions only.
- `ai_events` (user_id, kind, items_processed, tokens) → Insights page + rate limiting.
  `user_id` is **nullable**: ingest-news is shared work with no owning user, and a null row
  matches no RLS policy, so it stays out of every user's view and rate limit.

## Cost-aware news design (multi-user)

Never run the full Gemini pipeline per user. Built in Phase 3 and live:

1. `ingest-news` (cron, once daily ~06:30 IST / 01:00 UTC): for every category any enabled user
   follows, fetch that category's feeds, run the item pipeline below, then summarize + embed
   **once** into the shared `articles` pool.
2. `build-digests` (cron, right after): per user, a single Gemini call ranks that day's pooled
   articles for the user's categories against `profiles.news_profile`, picks top N, writes
   `why_it_matters`, and inserts `digests` + `news_items` (copying fields + embedding).
   Still to do (Phase 6) — follow-up linking: nearest neighbour among that user's `news_items`
   from the last 14 days (cosine similarity threshold ~0.85, tune it) → `related_item_id`.

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

### Measured in production (2026-10-12, 5 followed categories, 43 feeds)

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

### Google News is blocked from the Edge runtime — fetched from Postgres instead

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

## Cron (UTC)

| when           | job                         | what                                                                |
| -------------- | --------------------------- | ------------------------------------------------------------------- |
| `50 0 * * *`   | `prefetch-aggregator-feeds` | pg_net fetches the aggregator tier                                  |
| `0 1 * * *`    | `fanout-ingest-news`        | `fanout_ingest_news()` → one ingest-news call per followed category |
| `30 1 * * *`   | `build-digests`             | one Gemini call per user over the shared pool                       |
| `*/15 * * * *` | `send-briefs`               | emails whoever's `email_time` falls in this window                  |
| `* * * * *`    | `check-reminders`           | the task escalation ladder (see Notifications)                      |

Defined in `20261012072101_cron_schedules.sql`; `check-reminders` was moved to every
minute by `20261012090000_notifications.sql`. `invoke_edge_function(name, body)` reads
`project_url` and `cron_secret` from Vault, so no secret is ever inlined into a
`cron.job` row. **To run any of these by hand, call the same SQL** rather than inventing a
new path — it is the exact production path.

## Edge Functions

1. `parse-task` (user JWT) — free text → Gemini with JSON response schema → array of tasks.
   The parsing itself is `_shared/parse-tasks.ts`, shared with the Telegram bot so the
   prompt, schema and rate limit cannot drift between the two front doors. Each task carries
   (title, notes, due_at ISO with the user's UTC offset, all_day, recurrence, priority, tags,
   remind_before). Pass today's date, weekday and the user's timezone + existing tag names in the
   prompt. Returns a preview only; the UI saves. Rate limit: 50 calls/user/day (count `ai_events`).
2. `ingest-news` (cron secret) — builds the shared pool. Fetches only the categories some
   enabled user follows, applies the recency windows, junk filter and merge, cuts to 40
   candidates per category, then summarizes in batches of 12 on `GEMINI_BULK_MODEL` and embeds
   in batches of 50. Upserts into `articles` with `ignoreDuplicates`, so a URL already pooled is
   never re-summarized. Returns per-category counts, gemini_calls and token totals.
   **Repair pass:** `{"repair": true, "limit"?: n}` re-summarizes pooled articles whose
   summary is really just their headline — the scar `summarize` leaves whenever the model
   skips an item or a batch errors. It re-runs the same enrichment and summarizer, writes a
   fresh embedding (the old vector was derived from the bad summary), and carries the fix
   into any `news_items` row that still holds the old copy. Articles with no usable
   description are left alone rather than rewritten badly. Safe to re-run.
3. `build-digests` (cron secret, optional `{user_id, force}` body) — **one** Gemini call per user
   per day on `GEMINI_PARSE_MODEL`: it ranks that day's pool for the user's categories against
   `profiles.news_profile` and writes importance + why_it_matters. The model returns **indices**
   into the candidate list, never URLs or headlines — those are copied from `articles`, which is
   how the "URLs only from feed items" rule is enforced structurally. Writes `digests` +
   `news_items` and logs an `ai_events` row of kind `digest`.
4. `send-briefs` (cron every 15 min) — for each enabled user, is one of their `email_times`
   inside the current 15-minute window **in their timezone** and not yet sent today? Then build
   the email from what is already in the database — the digest's "at a glance", today's tasks,
   overdue, birthdays in the next 7 days, news by category with links — and send it. **No Gemini
   call.** Idempotency is the `brief_sends` unique constraint, claimed _before_ the send so two
   overlapping ticks cannot both email; a failed send **releases** the claim, otherwise one SMTP
   hiccup would mark the slot sent and the user would silently get nothing that day. An item with
   `url_resolved = false` is labelled "via Google News".
5. `check-reminders` (cron **every minute**) — the escalation ladder described under
   Notifications. Computes each open reminder task's stages, claims the current one in
   `task_notifications` per channel, fans out through `notify()`, releases the claim on a
   failed send, and stamps `last_reminded_at` for the rest of the app. A tick with nothing
   due is one indexed query and returns in well under a second.
6. `push-subscribe` (user JWT) — `{"action":"key"}` returns the VAPID public key;
   `subscribe` / `unsubscribe` store and drop a browser's `PushSubscription`; `test` sends
   a test notification. Subscribing switches the `push` channel on, and unsubscribing the
   **last** device switches it off — one laptop going quiet must not silence the phone.
   `test` calls `sendPush` directly rather than `notify()`: the user is standing there
   asking for it, so quiet hours are not what they're testing.
7. `push-action` (**no JWT**; authenticated by the HMAC action token described under
   Notifications) — the Done / Snooze 10m buttons on a desktop notification. Does nothing
   but those two mutations on the one task the token names.
8. `telegram-webhook` (**no JWT**; `x-telegram-bot-api-secret-token` verified against
   `TELEGRAM_WEBHOOK_SECRET`) — `/start <code>` linking, `/today` `/tasks` `/brief` `/help`,
   free text → `parseTasks()` → rows in `tasks` (no preview step in a chat), and the
   Done / Snooze 1h / Tomorrow buttons. Always answers 200 after the secret check, because a
   non-200 makes Telegram redeliver the update forever. Also self-registers on
   `{"register": true}` + `x-cron-secret`.

## Source map (`_shared/feeds.ts`) — all URLs verified 2026-10-12

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

### Feed gotchas (all of these cost an hour to find; don't rediscover them)

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

## Frontend routes

`/` landing (logged out) · `/login` · `/onboarding` · `/brief` · `/tasks` · `/news` · `/insights` · `/settings`

## Roadmap

- [ ] Phase 1: review Lovable draft against schema; fix data wiring, recurrence roll-forward, types
- [ ] Phase 2: `parse-task` + quick-add preview, rate limiting
- [x] Phase 3: `articles` pool migration, `ingest-news`, `build-digests`, `url_resolved` +
      "via Google News" tag in the news card. Both functions are deployed and have been run
      end to end; **cron is not wired yet** (that migration is Phase 4).
- [x] Phase 4: `send-briefs` + `check-reminders` + all five cron schedules. Gmail SMTP is
      live and verified: a real brief was delivered (20 stories, 2 tasks, 5.1s), `brief_sends`
      linked it to the digest and stamped `digests.emailed_at`, and re-firing the same slot
      answered "already sent" without a second email. `check-reminders` runs clean but its
      SMTP path is still unexercised — no task has `remind_before` set yet.
- [x] Phase 5: Notifications. `notification_prefs`, `task_notifications`,
      `tasks.snoozed_until`, `telegram_links`; `_shared/notify.ts`; check-reminders reworked
      into the escalation ladder on a per-minute cron; `telegram-webhook` with linking,
      inline buttons, commands and free-text task capture; Settings UI for channels, quiet
      hours and the nag interval.
      **Verified in production 2026-10-12:** Telegram linking end to end (`chat_id` bound,
      one-time code consumed, the `telegram` channel switched on by the webhook); `lead`
      delivered to email + Telegram at 14:21:04, one tick after its fire time; `15m`
      delivered to **Telegram only** with no email row written, which is the routing rule
      holding; the Done button completing a task from the chat. **Not yet exercised:** the
      `due` and `nag:k` rungs (the test task was completed four minutes before it came
      due), `1h`, quiet-hours suppression, snooze and Tomorrow, and the free-text →
      `parse-task` path from a chat.
- [ ] Phase 6: follow-up linking, Insights page with real data, PWA polish.
      **Browser notifications are done** (2026-10-12): in-app realtime toast + chime +
      tab/favicon badge, `push_subscriptions`, `public/sw.js`, `push-subscribe`,
      `push-action`, the `push` sender in `notify.ts`, and the Settings card with
      enable/test and the macOS "Alerts" hint. Verified: both functions boot in the Edge
      runtime (so `jsr:@negrel/webpush` resolves), `push-action` rejects an unsigned
      token, and check-reminders still returns 200 on the new module graph.
      **Not yet exercised:** a real end-to-end push to a granted browser, the Done /
      Snooze buttons from a notification, and expiry pruning on 404/410.
- [ ] Phase 7 (optional): weekly review email, "ask my news" chat, X highlights

## Working conventions

- Test each Edge Function by invoking it and reading logs via MCP before wiring cron.
- `npm run build` and `npm run lint` must pass before committing frontend changes.
- Shared helpers in `supabase/functions/_shared/` (gemini.ts, email.ts, notify.ts, push.ts,
  telegram.ts, supabase.ts, feeds.ts, time.ts, tasks.ts, parse-tasks.ts).
- Log every Gemini call to `ai_events`.
