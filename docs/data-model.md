# Data model

The source of truth is the migration files in `supabase/migrations/`. This is the map.

Every table has RLS on with `user_id = auth.uid()`. Where only some columns are user-writable, that is enforced by **column grant**, because RLS cannot express it.

### Data model (source of truth = migration files)

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
- `api_tokens` (user_id, name, token_hash **sha256 hex, unique**, prefix for display,
  last_used_at, revoked_at) — the MCP server's credentials. Minted only by
  `create_api_token()`; the plaintext exists in that one response and nowhere after.
  Owner may select/update/delete, but **column grants withhold `token_hash`**, so the
  frontend must select named columns and never `*`.
- `mcp_tool_calls` (user_id, token_id on delete set null, tool, ok, error, duration_ms)
  — one row per MCP tool call. The per-token rate limit counts it, and it is the only
  record of what an agent did while nobody was watching. Owner-readable.
- `notification_prefs.morning_time` (`time`, default 09:00) — what "tomorrow morning"
  resolves to; handed to the MCP client by `get_context`.
- `tasks.source` now allows `'mcp'`: neither hand-typed nor Gemini-parsed, and the one
  source where no human saw the task before it was saved.
- `prefetch_feeds` / `prefetch_requests` — plumbing for the Google News workaround below.
  RLS on with **no policies**: service role and SECURITY DEFINER functions only.
- `topics` (user_id, label, embedding vector(768), enabled, weight) — the interests a reader
  writes in their own words. HNSW index; unique on `(user_id, lower(btrim(label)))` so
  "coding" and "Coding" are one interest. **No insert policy**; UPDATE granted on `enabled`
  and `weight` only.
- `user_features` (user_id, feature, enabled) — the switches. An absent row means the default
  resolved in `_shared/features.ts`. Fully owner-managed, unlike the tables above, because
  changing it is the entire point.
- `plan_sends` (user_id, sent_for date, unique on both) — the planner's idempotency ledger,
  claimed before the Gemini call and released on a failed send. `brief_sends`' pattern.
- `mcp_tool_calls.surface` — which door made the call, defaulted to `'mcp'`.
- `tasks.source` now also allows `'agent'`: a conversation the user was present for, as
  distinct from `'ai'` (one parsed sentence they reviewed) and `'mcp'` (nobody watching).
- `ai_events.kind` now also allows `'agent'` and `'plan'`, each with its own daily limit.
- `ai_events` (user_id, kind, items_processed, tokens) → Insights page + rate limiting.
  `user_id` is **nullable**: ingest-news is shared work with no owning user, and a null row
  matches no RLS policy, so it stays out of every user's view and rate limit.
