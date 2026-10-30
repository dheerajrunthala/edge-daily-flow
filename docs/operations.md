# Operations

The cron schedule, what every Edge Function is for, and how to run any of it by hand.

To run a scheduled job manually, call the same SQL cron calls — it is the exact production path. See the `deploy-and-verify-fn` skill for the deploy loop.

### Cron (UTC)

| when            | job                         | what                                                                 |
| --------------- | --------------------------- | -------------------------------------------------------------------- |
| `50 0 * * *`    | `prefetch-aggregator-feeds` | pg_net fetches the aggregator tier                                   |
| `0 1 * * *`     | `fanout-ingest-news`        | `fanout_ingest_news()` → one ingest-news call per followed category  |
| `30 1 * * *`    | `build-digests`             | `fanout_build_digests()` → one invocation **per user** over the pool |
| `*/15 * * * *`  | `send-briefs`               | emails whoever's `email_time` falls in this window                   |
| `* * * * *`     | `check-reminders`           | the task escalation ladder (see Notifications)                       |
| `*/15 * * * *`  | `plan-day`                  | the morning plan, for users whose `morning_time` is in the window    |
| `0 3 * * *`     | `build-digests-retry`       | the same fan-out again; a no-op for any digest already `ready`       |
| `:07 :17 :27 …` | `repair-embeddings`         | 90 vectorless pooled articles per run, so a lost vector self-heals   |

Defined in `20261012072101_cron_schedules.sql`; `check-reminders` was moved to every
minute by `20261012090000_notifications.sql`. `invoke_edge_function(name, body)` reads
`project_url` and `cron_secret` from Vault, so no secret is ever inlined into a
`cron.job` row. **To run any of these by hand, call the same SQL** rather than inventing a
new path — it is the exact production path.

### Edge Functions

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
8. `mcp` (**no JWT**; `Authorization: Bearer de_...` against `api_tokens`) — the MCP server.
   See the section below; it is the only function that answers a protocol rather than a
   JSON body, and the only one whose caller is a config file rather than a session.
9. `agent` (user JWT) — the conversational door. Gemini tool-calling over
   `_shared/agent-registry.ts` with a per-surface allowlist, a 6-turn cap, and 60
   conversations/user/day counted off `ai_events`. Gated on the `chat` feature at its entry
   point. Returns the answer, its citations, the tool calls it made, and any link it cited
   that no tool returned.
10. `plan-day` (cron secret, every 15 min) — the autonomous morning planner. Read-only tool
    allowlist, gated on the `planner` feature (which defaults off), claimed in `plan_sends`
    before spending, delivered through `notify()` so it inherits quiet hours and the channel
    fan-out. Verified in production: 3 tool calls in one turn, answered by the fallback
    model, delivered on email + telegram + push.
11. `topics` (user JWT) — `preview` / `add` / `reembed`. The only path that creates a topic,
    because creating one means embedding its label and the browser never calls Gemini.
12. `telegram-webhook` (**no JWT**; `x-telegram-bot-api-secret-token` verified against
    `TELEGRAM_WEBHOOK_SECRET`) — `/start <code>` linking, `/today` `/tasks` `/brief` `/help`,
    free text → `parseTasks()` → rows in `tasks` (no preview step in a chat), and the
    Done / Snooze 1h / Tomorrow buttons. Always answers 200 after the secret check, because a
    non-200 makes Telegram redeliver the update forever. Also self-registers on
    `{"register": true}` + `x-cron-secret`.

## Why `repair-embeddings` runs at :07 and not `*/10`

`*/10` fires at minute **:00 of every hour** — including 01:00 UTC, the exact minute
`fanout-ingest-news` starts one ingest invocation per category, all of them embedding at once.
The repair's 90 requests would then compete with ingest's own for the same 100-per-minute free
tier quota, and the articles that lost would be _fresh_ ones — pooled vectorless and therefore
permanent. A repair job that causes the damage it repairs.

The odd offsets go further than avoiding :00: they share a minute with no other job here that
spends Gemini quota. Minutes :15 and :45 would in fact have been safe, because `send-briefs`
makes no Gemini call and the planner's read-only allowlist never embeds — but a schedule that
is safe only _because of a correct argument about what other jobs do_ stops being safe when one
of them changes.

The exception is `check-reminders`, which runs **every** minute and therefore shares a minute
with everything by construction. It is the one place that argument still has to be made, and it
holds: a tick is one indexed query and no model call. `scripts/db-checks.sql` asserts the
no-clash rule with `check-reminders` named as the exemption, so the claim is checked rather
than assumed.

Caught by the `schema-guardian` agent before the migration was applied; it could only know by
querying the live `cron.job` table and reading the function's own constants.
