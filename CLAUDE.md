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
embedding, fetched_on) with RLS allowing authenticated read:
1. `ingest-news` (cron, once daily ~06:30 IST / 01:00 UTC): for every category any enabled user
   follows, fetch RSS, dedupe, summarize + embed **once** into `articles`.
2. `build-digests` (cron, right after): per user, a single cheap Gemini call ranks that day's
   pooled articles for the user's categories against `profiles.news_profile`, picks top N, writes
   `why_it_matters`, and inserts `digests` + `news_items` (copying fields + embedding).
   Follow-up linking: nearest neighbour among that user's `news_items` from the last 14 days
   (cosine similarity threshold ~0.85, tune it) → `related_item_id`.
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

## RSS feed map (`_shared/feeds.ts`) — verify each URL works before relying on it
- AI: Google News RSS search "artificial intelligence", The Verge AI, Hacker News (filtered)
- Software Development: Hacker News, InfoQ, GitHub blog
- Indian Stock Market: Google News RSS (India edition, "Sensex OR Nifty"), Moneycontrol, ET Markets
- Indian Startups & Tech: Inc42, YourStory, Google News RSS (India, "startup")
- Global Tech: The Verge, TechCrunch, Ars Technica
- Policy & Regulation: Google News RSS ("tech regulation India" / "AI regulation")
- X/Twitter highlights: later phase (X API is paid). Option: Gemini with Google Search grounding,
  using only URLs from grounding metadata.

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
